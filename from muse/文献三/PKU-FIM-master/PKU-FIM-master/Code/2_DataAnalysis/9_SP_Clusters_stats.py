# -*-coding:utf-8 -*-
# python 3.9
# 给聚类结果进行分类，分成clustered, centered, belted, satellite

"""
# @File       : 9_SP_Clusters_stats.py
# @software   : PyCharm  
# @Time       ：2025/4/8 16:30
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

    result = pd.DataFrame(columns=['City', 'maxHull', 'clusterNum', 'stdNum', 'diff'])

    for i in range(len(cities_cn)):
        city = cities_cn[i]
        city_en = cities_en[i][:-3]
        if city_en == 'xian':
            city_en = 'xi\'an'
        if city_en == 'haerbin':
            city_en = 'harbin'
        city_path = outputPath + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
        file = 'clustered results.csv'
        df = pd.read_csv(city_path + '/' + file, header=0)
        # 长宽比最大的凸包
        maxHull = df.loc[df['label'] != -1, 'ConvexHull'].max()
        # cluster的数量
        num = len(df.loc[df['label'] != -1, 'label'].unique())
        # cluster标准差
        cluster_sizes = df.loc[df['label'] != -1, 'label'].value_counts()
        stdNum = cluster_sizes.std()

        diff = df.loc[df['label'] != -1, 'label'].value_counts().iloc[0] - df.loc[df['label'] != -1, 'label'].value_counts().iloc[1]

        result.loc[len(result)] = [city_en.capitalize(), maxHull, num, stdNum, diff]

    result.to_csv(r'D:\LW\ABM\OutputData\Result\cities_21_max\Inflow\sigma=1\NumPerShelter\cluster results_stats.csv', header=True, index=False)

    centralized = list(result.loc[result['diff'] > 1500, 'City'])
    belted = list(result.loc[(result['diff'] <= 1500) & (result['stdNum'] > 200) & (result['maxHull'] > 3.5), 'City'])
    satellite = list(result.loc[(result['diff'] <= 1500) & (result['stdNum'] > 200) & (result['maxHull'] <= 3.5), 'City'])
    clustered = list(result.loc[(result['diff'] <= 1500) & (result['stdNum'] <= 200), 'City'])

    print('centralized: ', centralized)
    print('belted: ', belted)
    print('satellite: ', satellite)
    print('clustered: ', clustered)

    print()
