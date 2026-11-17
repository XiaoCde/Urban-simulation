# -*-coding:utf-8 -*-
# Python 3.9
# 生成4 quadrants

"""
# @File       : 10_Global SA and prop.py
# @software   : PyCharm  
# @Time       ：2025/4/2 19:52
# @Author     ：Wei Lyu
"""

import pandas as pd


if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    sigma = 1

    relation = pd.read_csv(outputPath + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    del relation

    results = pd.DataFrame([], columns=['City', 'Prop_deficit', 'SA_deficit', 'Prop_surplus', 'SA_surplus'])


    for i in range(len(cities_cn)):
        cities_en[i] = cities_en[i][:-3]
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'
        city = cities_cn[i]
        basePath = outputPath + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)

        file = 'sa_deficit.csv'
        df = pd.read_csv(basePath + '\\' + file, header=0)
        df_defic = df[df['Code_defic'] == 1]

        file = 'sa_surplus.csv'
        df = pd.read_csv(basePath + '\\' + file, header=0)
        df_surpl = df[df['Code_surpl'] == 1]

        prop1 = len(df_defic) / (len(df_defic) + len(df_surpl)) # 注意这里的基数是mismatches
        df_tmp = df_defic['JC']/df_defic['NN']
        sa1 = df_tmp.sum() / len(df_defic)

        prop2 = len(df_surpl) / (len(df_defic) + len(df_surpl))
        df_tmp = df_surpl['JC'] / df_surpl['NN']
        sa2 = df_tmp.sum() / len(df_surpl)

        results.loc[len(results)] = [cities_en[i].capitalize(), prop1, sa1, prop2, sa2]

    results.to_csv(r'D:\LW\ABM\OutputData\Result\cities_21_max\Inflow\sigma=1\NumPerShelter\fourQuadrants.csv', header=True, index=False)
