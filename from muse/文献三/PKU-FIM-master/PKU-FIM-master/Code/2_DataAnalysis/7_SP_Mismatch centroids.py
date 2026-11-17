# -*-coding:utf-8 -*-
# Python 2.7
# 提取21个城市mismatch区域的中心坐标
"""
# @File       : 7_SP_Mismatch centroids.py
# @software   : PyCharm  
# @Time       ：2025/4/8 11:25
# @Author     ：Wei Lyu
"""

import arcpy
import pandas as pd
import os

if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    sigma = 1

    relation = pd.read_csv(outputPath + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    del relation

    # for city in cities_cn:
    # 创建空列表存储结果
    city = cities_cn[20]
    results = []

    city_path = outputPath + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
    file = 'sa.shp'
    shp = city_path + '/' + file

   
    # 使用SearchCursor遍历要素
    with arcpy.da.SearchCursor(shp, ["match_type", "SHAPE@"]) as cursor:
        for row in cursor:
            match_type = row[0]
            geometry = row[1]

            # 筛选Match_type不等于"balance"的要素
            if match_type != "balance":
                # 计算几何中心（考虑要素可能是面或线）
                centroid = geometry.centroid
                results.append({
                    "filename": os.path.basename(shp),
                    "match_type": match_type,
                    "x": centroid.X,
                    "y": centroid.Y
                })


    # 将结果保存到CSV
    output_csv = os.path.join(city_path, "mismatch_centroids.csv")
    with open(output_csv, 'w') as f:
        f.write("Filename,Match_type,X,Y\n")
        for item in results:
            f.write("{},{},{},{}\n".format(
                item['filename'],
                item['match_type'],
                item['x'],
                item['y']
            ))

