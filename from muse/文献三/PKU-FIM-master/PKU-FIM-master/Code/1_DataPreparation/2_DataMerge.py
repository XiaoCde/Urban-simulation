# -*-coding:utf-8 -*-
# python 3.9

"""
# @File       : 2_DataMerge.py.py
# @software   : PyCharm  
# @Time       ：2024/6/5 9:07
# @Author     ：Wei Lyu
"""

import pandas as pd
# import numpy as np

if __name__ == '__main__':

    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'
    city = 'zhengzhou'


    studyarea = pd.read_csv(outputPath + '/studyarea_tid.csv', header=0, usecols=['Tid'])
    studyarea_tids = studyarea['Tid'].unique().tolist()
    del studyarea

    # boundary box
    bbox = pd.read_csv(outputPath + '/zz_bbox_tid.csv', header=0, usecols=['OBJECTID', 'Tid'])
    

    helpInfo_layer = pd.read_csv(outputPath + '/' + city + '/simul_hazard_tid.csv', header=0)

    # constrained pop
    pop_con = pd.read_csv(outputPath + '/zz_bbox_zonal_ppp.csv', header=0, usecols=['OBJECTID', 'Tid', 'SUM'])
    # CBRA
    CBRA = pd.read_csv(outputPath + '/' + 'CBRA_zz_bbox_resample.csv', header=0, usecols=['OBJECTID', 'Tid', 'SUMdivide255'])
    # County
    County = pd.read_csv(outputPath + '/' + 'zz_bbox_sj_county.csv', header=0, usecols=['OBJECTID', 'Tid', 'county_id'])
    County = County.fillna(0)
    # Inflow_truth
    Inflow_truth = pd.read_csv(outputPath + '/inflow_dur_aveHour.csv', header=0)
    Inflow_truth.columns = ['Tid', 'Inflow_ave']

    df = pd.merge(bbox, helpInfo_layer, how='left', left_on='Tid', right_on='Tid')

    df['OBJECTID_y'] = df['OBJECTID_y'].notnull().astype('int') 


    df = pd.merge(df, pop_con, how='left', left_on='Tid', right_on='Tid')
    df.drop(['OBJECTID'], axis=1, inplace=True)
    df['SUM'] = df['SUM'].fillna(0)

    df = pd.merge(df, CBRA, how='left', left_on='OBJECTID_x', right_on='OBJECTID')
    df.drop(['OBJECTID', 'Tid_y'], axis=1, inplace=True)
    df['SUMdivide255'] = df['SUMdivide255'].astype(int)

    df = pd.merge(df, County, how='left', left_on='OBJECTID_x', right_on='OBJECTID')
    df.drop(['Tid', 'OBJECTID'], axis=1, inplace=True)
    df['county_id'] = df['county_id'].astype(int)

    df = pd.merge(df, Inflow_truth, how='left', left_on='Tid_x', right_on='Tid')
    df.drop(['Tid'], axis=1, inplace=True)
    df['Inflow_ave'] = df['Inflow_ave'].fillna(0)

    # rename & astype
    df.columns = ['FID', 'Tid', 'Hazard', 'Con_pop', 'CBRA', 'County', 'Inflow_truth']
    ind = df[~df['Tid'].isin(studyarea_tids)]['FID'].to_list()
    ind = [item-1 for item in ind]
    df.loc[ind, 'Tid'] = -2
    df.loc[ind, 'Inflow_truth'] = -2

    df.to_csv(outputPath + '/Result/' + city + '/model_input.csv', header=True, index=False)
